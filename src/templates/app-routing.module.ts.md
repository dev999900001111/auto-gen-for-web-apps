import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
  
{{routeImports}}

const routes: Routes = [
{{routingPath}},
  { path: '**', redirectTo: 'login' } // 未定義のルートの場合はログインページにリダイレクトする
];

@NgModule({
  imports: [RouterModule.forRoot(routes, { useHash: true })],
  exports: [RouterModule]
})
export class AppRoutingModule { }

